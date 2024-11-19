# MoneyMinder
a fintech app to promoting financial independence, made for college students to manage bills and budgets
the last two pages of nav bar dont work(lack of time, also forget password doesn't work for now)

this website is designed only for phones.
kindly use inspect and phone mode on pc or host the node js code on mobile to view the website properly.

for PC(vs code), to run using local host, local host login.html. 

to run using node js, 
run the following command in the folder in which you downloaded in cmd:(vc code terminal might not work)
npm install mindee express multer cors(just to be safe as it sometimes shows errors, if it doesn't just directly run code)

to run code, use cmd: node app.js

After registering, you enter the home page where you can see your budget and expenditure
(the buddget entered during register is monthly and divided by 30 to get daily budget)

The line above uses the date and total expenditure to determine wether you are behind or doing good(for example if its day 15 and your daily budget us 1000 but you have spent 17000, it will inform you to reduce spending for the rest of the month)

The expenditure is also auto categorized.

the first icon on nav bar is where you can view the already scanned receipts. You can also click on them to view info in detail.

then second icon is the home page.

The large middle icon is scan page

On scan page, the first button is to upload files and the second is to submit them(if using inspect), otherwise the second also serves as a camera to click pictures with.

After submit, you are redirected to home page.

Thanks for viewing, hope the app helps you.